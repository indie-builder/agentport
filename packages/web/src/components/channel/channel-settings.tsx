import {
  type ChannelAgentBinding,
  type ChannelDetail,
  type ChannelMember,
  type ChannelRole,
  channelMemberInputSchema,
  channelUpdateSchema,
} from '@agentport/shared';
import { useNavigate } from '@tanstack/react-router';
import { Plus, Settings, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Controller, type UseFormReturn } from 'react-hook-form';
import type { z } from 'zod';
import { shortId } from '../../lib/format.js';
import {
  useAddChannelMember,
  useBindChannelAgent,
  useCloseChannel,
  useDisconnectChannelAgent,
  useRemoveChannelAgent,
  useRemoveChannelMember,
  useUpdateChannel,
  useUpdateChannelAgent,
  useUpdateChannelMember,
} from '../../lib/queries.js';
import { toastError, toastSuccess } from '../../lib/toast.js';
import { useZodForm } from '../../lib/use-zod-form.js';
import { AgentAvatar } from '../agent/agent-avatar.js';
import { AgentPicker } from '../agent/agent-picker.js';
import { ConfirmDialog } from '../confirm-dialog.js';
import { DialogShell } from '../dialog-shell.js';
import { DraftGuardDialogs, useDraftGuard } from '../knowledge/knowledge-shared.js';
import { RequiredMark } from '../required-mark.js';
import { Badge } from '../ui/badge.js';
import { Button } from '../ui/button.js';
import { Dialog } from '../ui/dialog.js';
import { Field, FieldDescription, FieldError, FieldLabel } from '../ui/field.js';
import { Input } from '../ui/input.js';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select.js';
import { Switch } from '../ui/switch.js';
import { Textarea } from '../ui/textarea.js';

const ROLE_LABEL: Record<ChannelRole, string> = {
  owner: '所有者',
  admin: '管理员',
  member: '成员',
  viewer: '只读',
};

const ROLE_OPTIONS = (Object.keys(ROLE_LABEL) as ChannelRole[]).map((value) => ({
  value,
  label: ROLE_LABEL[value],
}));

const BINDING_STATUS_LABEL: Record<ChannelAgentBinding['status'], string> = {
  active: '已启用',
  disconnected: '已断开',
};

type ChannelUpdateForm = UseFormReturn<
  z.input<typeof channelUpdateSchema>,
  unknown,
  z.output<typeof channelUpdateSchema>
>;

type ChannelMemberForm = UseFormReturn<
  z.input<typeof channelMemberInputSchema>,
  unknown,
  z.output<typeof channelMemberInputSchema>
>;

export function ChannelSettingsButton({
  channel,
  businessId,
  role,
  agents,
}: {
  channel: ChannelDetail;
  businessId: string | null;
  role: ChannelRole | null;
  agents: { id: string; name: string; description: string; enabled: boolean }[];
}): ReactNode {
  const [open, setOpen] = useState(false);
  if ((role !== 'owner' && role !== 'admin') || channel.archivedAt !== null) return null;
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Settings aria-hidden="true" />
        频道设置
      </Button>
      {open ? (
        <ChannelSettingsDialog
          channel={channel}
          businessId={businessId}
          role={role}
          agents={agents}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function ChannelSettingsDialog({
  channel,
  businessId,
  role,
  agents,
  onClose,
}: {
  channel: ChannelDetail;
  businessId: string | null;
  role: ChannelRole;
  agents: { id: string; name: string; description: string; enabled: boolean }[];
  onClose: () => void;
}) {
  const update = useUpdateChannel(channel.id);
  const addMember = useAddChannelMember(channel.id);
  const basic = useZodForm(channelUpdateSchema, {
    defaultValues: { name: channel.name, description: channel.description ?? '' },
  });
  const member = useZodForm(channelMemberInputSchema, {
    defaultValues: { businessId: '', role: 'member' },
  });
  const dirty = basic.formState.isDirty || member.formState.isDirty;
  const pending =
    update.isPending ||
    basic.formState.isSubmitting ||
    addMember.isPending ||
    member.formState.isSubmitting;
  const guard = useDraftGuard(dirty, pending, onClose);

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        if (pending) {
          details.cancel();
          return;
        }
        if (!next) guard.close();
      }}
    >
      <DialogShell title="频道设置" closeDisabled={pending}>
        <div className="flex flex-col gap-5">
          <BasicInfoSection form={basic} update={update} />
          <MembersSection
            channel={channel}
            businessId={businessId}
            role={role}
            form={member}
            addMember={addMember}
          />
          <AgentsSection channel={channel} agents={agents} />
          {role === 'owner' ? <CloseChannelSection channel={channel} guard={guard} /> : null}
        </div>
        <DraftGuardDialogs guard={guard} draft="频道设置草稿会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}

function BasicInfoSection({
  form,
  update,
}: {
  form: ChannelUpdateForm;
  update: ReturnType<typeof useUpdateChannel>;
}) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty, isSubmitting },
  } = form;
  const saving = update.isPending || isSubmitting;

  const submit = handleSubmit(async (values) => {
    const description = values.description?.trim();
    try {
      const saved = await update.mutateAsync({
        ...(values.name === undefined ? {} : { name: values.name }),
        description: description ? description : null,
      });
      toastSuccess('基本信息已保存');
      reset({ name: saved.name, description: saved.description ?? '' });
    } catch (error) {
      toastError(error);
    }
  });

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-fg">基本信息</h2>
      <form className="flex flex-col gap-3" noValidate onSubmit={submit}>
        <Field className="gap-1.5" data-disabled={saving} data-invalid={Boolean(errors.name)}>
          <FieldLabel htmlFor="channel-settings-name">
            名称
            <RequiredMark />
          </FieldLabel>
          <Input
            {...register('name')}
            id="channel-settings-name"
            placeholder="例如：产品发布"
            disabled={saving}
            aria-invalid={Boolean(errors.name)}
            aria-describedby={errors.name ? 'channel-settings-name-error' : undefined}
          />
          <FieldError id="channel-settings-name-error">{errors.name?.message}</FieldError>
        </Field>
        <Field
          className="gap-1.5"
          data-disabled={saving}
          data-invalid={Boolean(errors.description)}
        >
          <FieldLabel htmlFor="channel-settings-description">描述</FieldLabel>
          <Textarea
            {...register('description')}
            id="channel-settings-description"
            rows={3}
            placeholder="这个频道用来做什么"
            disabled={saving}
            aria-invalid={Boolean(errors.description)}
            aria-describedby={errors.description ? 'channel-settings-description-error' : undefined}
          />
          <FieldError id="channel-settings-description-error">
            {errors.description?.message}
          </FieldError>
        </Field>
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={saving || !isDirty} aria-busy={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </form>
    </section>
  );
}

function MembersSection({
  channel,
  businessId,
  role,
  form,
  addMember,
}: {
  channel: ChannelDetail;
  businessId: string | null;
  role: ChannelRole;
  form: ChannelMemberForm;
  addMember: ReturnType<typeof useAddChannelMember>;
}) {
  const updateMember = useUpdateChannelMember(channel.id);
  const removeMember = useRemoveChannelMember(channel.id);
  const [removing, setRemoving] = useState<ChannelMember | null>(null);
  const [roleDraft, setRoleDraft] = useState<Record<string, ChannelRole>>({});
  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = form;
  const addPending = addMember.isPending || isSubmitting;
  const roleOptions =
    role === 'owner' ? ROLE_OPTIONS : ROLE_OPTIONS.filter((item) => item.value !== 'owner');

  const changeRole = (member: ChannelMember, next: ChannelRole): void => {
    if (next === member.role) return;
    setRoleDraft((current) => ({ ...current, [member.businessId]: next }));
    updateMember.mutate(
      { businessId: member.businessId, role: next },
      {
        onSuccess: () => {
          toastSuccess('成员角色已更新');
          setRoleDraft(({ [member.businessId]: _removed, ...rest }) => rest);
        },
        onError: (error) => {
          toastError(error);
          setRoleDraft(({ [member.businessId]: _removed, ...rest }) => rest);
        },
      },
    );
  };

  const add = handleSubmit(async (values) => {
    try {
      await addMember.mutateAsync(values);
      reset();
      toastSuccess('成员已添加');
    } catch (error) {
      toastError(error);
    }
  });

  return (
    <section className="flex flex-col gap-3 border-t border-line pt-5">
      <h2 className="text-sm font-medium text-fg">成员</h2>
      <ul className="flex flex-col">
        {channel.members.map((member) => {
          const label = member.name ?? shortId(member.businessId);
          const currentRole = roleDraft[member.businessId] ?? member.role;
          const roleSaving =
            updateMember.isPending && updateMember.variables?.businessId === member.businessId;
          const canChangeRole =
            businessId !== null && member.businessId !== businessId && member.role !== 'owner';
          const canRemove =
            businessId !== null &&
            member.businessId !== businessId &&
            (role === 'owner' || member.role !== 'owner');
          return (
            <li
              key={member.businessId}
              className="flex min-w-0 items-center gap-3 border-b border-line py-2 last:border-b-0"
            >
              <span
                aria-hidden="true"
                className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sunken text-2xs font-medium text-muted-foreground"
              >
                {label.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm text-fg" title={label}>
                {label}
              </span>
              {canChangeRole ? (
                <Select
                  value={currentRole}
                  onValueChange={(next) => {
                    if (next !== null) changeRole(member, next);
                  }}
                  items={roleOptions}
                  disabled={roleSaving}
                >
                  <SelectTrigger size="sm" aria-label={`${label} 的角色`}>
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
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {ROLE_LABEL[member.role]}
                </span>
              )}
              {canRemove ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`移除 ${label}`}
                  disabled={removeMember.isPending && removeMember.variables === member.businessId}
                  onClick={() => setRemoving(member)}
                >
                  <Trash2 aria-hidden="true" className="text-destructive" />
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {businessId !== null ? (
        <form className="flex flex-col gap-3" noValidate onSubmit={add}>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Field
              className="min-w-0 flex-1 gap-1.5"
              data-disabled={addPending}
              data-invalid={Boolean(errors.businessId)}
            >
              <FieldLabel htmlFor="channel-settings-member-business-id">业务 ID</FieldLabel>
              <Input
                {...register('businessId')}
                id="channel-settings-member-business-id"
                placeholder="biz_..."
                disabled={addPending}
                aria-invalid={Boolean(errors.businessId)}
                aria-describedby={
                  errors.businessId
                    ? 'channel-settings-member-business-id-error'
                    : 'channel-settings-member-business-id-hint'
                }
              />
              {errors.businessId ? (
                <FieldError id="channel-settings-member-business-id-error">
                  {errors.businessId.message}
                </FieldError>
              ) : (
                <FieldDescription id="channel-settings-member-business-id-hint">
                  可从成员的账号详情中获取。
                </FieldDescription>
              )}
            </Field>
            <Field className="w-32 shrink-0 gap-1.5" data-disabled={addPending}>
              <FieldLabel htmlFor="channel-settings-member-role">角色</FieldLabel>
              <Controller
                control={control}
                name="role"
                render={({ field }) => (
                  <Select
                    value={field.value ?? 'member'}
                    onValueChange={(next) => {
                      if (next !== null) field.onChange(next);
                    }}
                    items={roleOptions}
                    disabled={addPending}
                  >
                    <SelectTrigger
                      id="channel-settings-member-role"
                      ref={field.ref}
                      onBlur={field.onBlur}
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
                )}
              />
            </Field>
          </div>
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={addPending} aria-busy={addPending}>
              {addPending ? '添加中…' : '添加成员'}
            </Button>
          </div>
        </form>
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="移除成员？"
        description={
          removing === null
            ? ''
            : `${removing.name ?? shortId(removing.businessId)} 将不能再访问该频道，其进行中的运行会停止。`
        }
        confirmLabel="移除"
        onConfirm={async () => {
          if (removing === null) return;
          await removeMember.mutateAsync(removing.businessId);
          toastSuccess('成员已移除');
        }}
      />
    </section>
  );
}

function AgentsSection({
  channel,
  agents,
}: {
  channel: ChannelDetail;
  agents: { id: string; name: string; description: string; enabled: boolean }[];
}) {
  const bind = useBindChannelAgent(channel.id);
  const update = useUpdateChannelAgent(channel.id);
  const disconnect = useDisconnectChannelAgent(channel.id);
  const remove = useRemoveChannelAgent(channel.id);
  const [selected, setSelected] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState<ChannelAgentBinding | null>(null);
  const [removing, setRemoving] = useState<ChannelAgentBinding | null>(null);
  const bound = new Set(channel.agentBindings.map((binding) => binding.agentId));
  const bindable = agents.filter((agent) => agent.enabled && !bound.has(agent.id));
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const selectedAgent = bindable.find((agent) => agent.id === selected) ?? null;
  const nameOf = (binding: ChannelAgentBinding): string =>
    agentById.get(binding.agentId)?.name ?? shortId(binding.agentId);

  return (
    <section className="flex flex-col gap-3 border-t border-line pt-5">
      <h2 className="text-sm font-medium text-fg">智能体</h2>
      <ul className="flex flex-col">
        {channel.agentBindings.map((binding) => {
          const agent = agentById.get(binding.agentId);
          const label = nameOf(binding);
          const disconnectingThis =
            disconnect.isPending && disconnect.variables === binding.agentId;
          const removingThis = remove.isPending && remove.variables === binding.agentId;
          const updatingThis = update.isPending && update.variables?.agentId === binding.agentId;
          return (
            <li
              key={binding.agentId}
              className="flex min-w-0 items-center gap-3 border-b border-line py-2 last:border-b-0"
            >
              <AgentAvatar agent={agent ?? { name: label, description: '' }} className="size-7" />
              <span className="min-w-0 flex-1 truncate text-sm text-fg" title={label}>
                {label}
              </span>
              <Badge variant={binding.status === 'active' ? 'default' : 'outline'}>
                {BINDING_STATUS_LABEL[binding.status]}
              </Badge>
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                响应 @all
                <Switch
                  size="sm"
                  checked={binding.autoWakeOnAll}
                  disabled={binding.status === 'disconnected' || updatingThis}
                  aria-label={`${label} 响应 @all`}
                  onCheckedChange={(checked) =>
                    update.mutate(
                      { agentId: binding.agentId, autoWakeOnAll: checked },
                      {
                        onSuccess: () =>
                          toastSuccess(
                            checked
                              ? `已开启「${label}」的 @all 响应`
                              : `已关闭「${label}」的 @all 响应`,
                          ),
                        onError: (error) => toastError(error),
                      },
                    )
                  }
                />
              </span>
              {binding.status !== 'disconnected' ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disconnectingThis}
                  aria-busy={disconnectingThis}
                  aria-label={`断开 ${label}`}
                  onClick={() => setDisconnecting(binding)}
                >
                  断开
                </Button>
              ) : null}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`移除 ${label}`}
                disabled={removingThis}
                onClick={() => setRemoving(binding)}
              >
                <Trash2 aria-hidden="true" className="text-destructive" />
              </Button>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground">
        开启「响应 @all」的智能体会被「通知全部」唤醒。
      </p>
      {bindable.length > 0 ? (
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <AgentPicker
              triggerVariant="field"
              agent={selectedAgent}
              agentId={selected}
              agentOptions={bindable.map((agent) => ({
                value: agent.id,
                label: agent.name,
                agent,
              }))}
              onSwitchAgent={(id) => setSelected(id)}
              placeholder="选择智能体"
              triggerAriaLabel="选择要绑定的智能体"
              disabled={bind.isPending}
              triggerClassName="w-full"
            />
          </div>
          <Button
            size="sm"
            disabled={selected === null || bind.isPending}
            aria-busy={bind.isPending}
            onClick={() => {
              if (selected === null) return;
              bind.mutate(
                { agentId: selected },
                {
                  onSuccess: () => {
                    setSelected(null);
                    toastSuccess('智能体已绑定');
                  },
                  onError: (error) => toastError(error),
                },
              );
            }}
          >
            <Plus aria-hidden="true" />
            绑定智能体
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={disconnecting !== null}
        onClose={() => setDisconnecting(null)}
        title="断开智能体？"
        description={
          disconnecting === null
            ? ''
            : `${nameOf(disconnecting)} 的活动运行会停止，之后不再响应频道消息。`
        }
        confirmLabel="断开"
        onConfirm={async () => {
          if (disconnecting === null) return;
          await disconnect.mutateAsync(disconnecting.agentId);
          toastSuccess('智能体已断开');
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="移除智能体？"
        description={
          removing === null ? '' : `${nameOf(removing)} 将不再出现在该频道，其进行中的运行会停止。`
        }
        confirmLabel="移除"
        onConfirm={async () => {
          if (removing === null) return;
          await remove.mutateAsync(removing.agentId);
          toastSuccess('智能体已移除');
        }}
      />
    </section>
  );
}

function CloseChannelSection({
  channel,
  guard,
}: {
  channel: ChannelDetail;
  guard: ReturnType<typeof useDraftGuard>;
}) {
  const close = useCloseChannel(channel.id);
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);

  return (
    <section className="flex flex-col gap-3 border-t border-line pt-5">
      <h2 className="text-sm font-medium text-fg">关闭频道</h2>
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          关闭后历史仍可查看，但不能再发消息或触发智能体，进行中的运行会停止。
        </p>
        <Button variant="destructive" onClick={() => setConfirming(true)}>
          关闭频道
        </Button>
      </div>
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="关闭频道？"
        description="关闭后历史仍可查看，但不能再发消息或触发智能体，进行中的运行会停止。"
        confirmLabel="关闭频道"
        onConfirm={async () => {
          await close.mutateAsync();
          toastSuccess('频道已关闭');
          guard.finish();
          void navigate({ to: '/channels', ignoreBlocker: true });
        }}
      />
    </section>
  );
}
