import { type ChannelListItem, channelCreateSchema } from '@agentport/shared';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Hash, Plus } from 'lucide-react';
import { useState } from 'react';
import { DialogShell } from '../components/dialog-shell.js';
import { Page, PageHeader, PageSection } from '../components/page.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import { Dialog } from '../components/ui/dialog.js';
import { Field, FieldError, FieldLabel } from '../components/ui/field.js';
import { Input } from '../components/ui/input.js';
import { Textarea } from '../components/ui/textarea.js';
import { can } from '../lib/access.js';
import { cn } from '../lib/cn.js';
import { formatRelative } from '../lib/format.js';
import { channelQuery, meQuery, useChannels, useCreateChannel } from '../lib/queries.js';
import { toastError } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';

export function ChannelsPage() {
  const me = useQuery(meQuery);
  const channels = useChannels();
  const canCreate = can(me.data, 'conversations.create');
  const [creating, setCreating] = useState(false);
  const items = channels.data ?? [];
  // 列表只带最后一条消息；成员/智能体数量按详情补齐，数量少且与列表同屏可见。
  const details = useQueries({
    queries: items.map((channel) => ({ ...channelQuery(channel.id), staleTime: 30_000 })),
  });

  return (
    <Page>
      <PageHeader
        title="频道"
        actions={
          canCreate ? (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              新建频道
            </Button>
          ) : undefined
        }
      />
      {channels.isPending ? (
        <LoadingState rows={4} />
      ) : channels.isError ? (
        <ErrorState error={channels.error} onRetry={() => void channels.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Hash className="size-5" />}
          title="从第一个频道开始"
          description={
            canCreate
              ? '频道让多人、多个智能体在同一个时间线里协作。'
              : '管理员把你加入频道后，频道会出现在这里。'
          }
          action={
            canCreate ? (
              <Button variant="outline" onClick={() => setCreating(true)}>
                <Plus aria-hidden="true" />
                新建频道
              </Button>
            ) : undefined
          }
        />
      ) : (
        <PageSection>
          <ul className="divide-y divide-line overflow-hidden rounded-card border border-line">
            {items.map((channel, index) => (
              <li key={channel.id}>
                <ChannelRow
                  channel={channel}
                  memberCount={details[index]?.data?.members.length}
                  agentCount={details[index]?.data?.agentBindings.length}
                />
              </li>
            ))}
          </ul>
        </PageSection>
      )}
      {creating ? <CreateChannelDialog onClose={() => setCreating(false)} /> : null}
    </Page>
  );
}

function ChannelRow({
  channel,
  memberCount,
  agentCount,
}: {
  channel: ChannelListItem;
  memberCount: number | undefined;
  agentCount: number | undefined;
}) {
  const last = channel.lastMessage;
  const summary = last === null ? '还没有消息' : last.body;

  return (
    <Link
      to="/channels/$channelId"
      params={{ channelId: channel.id }}
      className={cn(
        'flex min-w-0 items-start gap-3 px-4 py-3 transition-colors duration-150 ease-out-soft hover:bg-hover',
        channel.archivedAt && 'opacity-70',
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-item bg-sunken text-muted-foreground">
        <Hash aria-hidden="true" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-base font-medium text-fg">{channel.name}</span>
          {channel.archivedAt ? <Badge variant="outline">已关闭</Badge> : null}
        </div>
        <p className="min-w-0 truncate text-sm text-muted-foreground">{summary}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted-foreground">
        {channel.unreadCount > 0 ? (
          <Badge aria-label={`${channel.unreadCount} 条未读`}>{channel.unreadCount}</Badge>
        ) : null}
        <span className="whitespace-nowrap">
          {memberCount === undefined ? '成员 —' : `${memberCount} 成员`}
          {agentCount === undefined ? '' : ` · ${agentCount} 智能体`}
        </span>
        <span className="whitespace-nowrap">{formatRelative(last?.createdAt)}</span>
      </div>
    </Link>
  );
}

function CreateChannelDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const create = useCreateChannel();
  const form = useZodForm(channelCreateSchema, {
    defaultValues: { name: '', description: '' },
  });
  const {
    register,
    handleSubmit,
    formState: { errors, isDirty, isSubmitting },
  } = form;
  const pending = create.isPending || isSubmitting;

  const submit = handleSubmit((values) => {
    const description = values.description?.trim();
    create.mutate(
      { name: values.name, ...(description ? { description } : {}) },
      {
        onSuccess: (channel) => {
          void navigate({ to: '/channels/$channelId', params: { channelId: channel.id } });
        },
        onError: (error) => toastError(error),
      },
    );
  });

  return (
    <Dialog
      open
      onOpenChange={(next, details) => {
        // 有草稿或请求在途时 Esc / 外部点击不直接丢弃。
        if (!next && (pending || isDirty)) {
          details.cancel();
          return;
        }
        if (!next) onClose();
      }}
    >
      <DialogShell title="新建频道" closeDisabled={pending}>
        <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
          <Field className="gap-1.5" data-invalid={Boolean(errors.name)}>
            <FieldLabel htmlFor="channel-name">名称</FieldLabel>
            <Input
              {...register('name')}
              id="channel-name"
              placeholder="例如：产品发布"
              disabled={pending}
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? 'channel-name-error' : undefined}
            />
            {errors.name ? (
              <FieldError id="channel-name-error">{errors.name.message}</FieldError>
            ) : null}
          </Field>
          <Field className="gap-1.5" data-invalid={Boolean(errors.description)}>
            <FieldLabel htmlFor="channel-description">描述</FieldLabel>
            <Textarea
              {...register('description')}
              id="channel-description"
              rows={3}
              placeholder="这个频道用来做什么"
              disabled={pending}
              aria-invalid={Boolean(errors.description)}
              aria-describedby={errors.description ? 'channel-description-error' : undefined}
            />
            {errors.description ? (
              <FieldError id="channel-description-error">{errors.description.message}</FieldError>
            ) : null}
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending ? '创建中…' : '创建频道'}
            </Button>
          </div>
        </form>
      </DialogShell>
    </Dialog>
  );
}
