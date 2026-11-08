import { type ChannelListItem, channelCreateSchema } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Hash, Plus } from 'lucide-react';
import { useState } from 'react';
import { DialogShell } from '../components/dialog-shell.js';
import { DraftGuardDialogs, useDraftGuard } from '../components/knowledge-shared.js';
import {
  Page,
  PageBody,
  PageHeader,
  PageNote,
  PageSection,
  PageTopbar,
} from '../components/page.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Badge } from '../components/ui/badge.js';
import { Button } from '../components/ui/button.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card.js';
import { Dialog } from '../components/ui/dialog.js';
import { Field, FieldError, FieldLabel } from '../components/ui/field.js';
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
import { type ListView, ViewToggle } from '../components/view-toggle.js';
import { can } from '../lib/access.js';
import { cn } from '../lib/cn.js';
import { formatRelative } from '../lib/format.js';
import { meQuery, useChannels, useCreateChannel } from '../lib/queries.js';
import { toastError } from '../lib/toast.js';
import { useZodForm } from '../lib/use-zod-form.js';

export function ChannelsPage() {
  const me = useQuery(meQuery);
  const channels = useChannels();
  const navigate = useNavigate({ from: '/channels/' });
  const search = useSearch({ from: '/_shell/channels/' });
  const view = search.view ?? 'cards';
  const setView = (next: ListView): void => {
    void navigate({ to: '/channels', search: { ...search, view: next }, replace: true });
  };
  const canCreate = can(me.data, 'conversations.create');
  const [creating, setCreating] = useState(false);
  const items = channels.data ?? [];
  const showCreate =
    canCreate &&
    (channels.isPending || (channels.isError && channels.data === undefined) || items.length > 0);

  return (
    <Page>
      <PageTopbar>
        <PageHeader
          title="频道"
          {...(items.length > 0 ? { description: `${items.length} 个频道` } : {})}
          actions={
            items.length > 0 || showCreate ? (
              <>
                {items.length > 0 ? <ViewToggle value={view} onChange={setView} /> : null}
                {showCreate ? (
                  <Button onClick={() => setCreating(true)}>
                    <Plus aria-hidden="true" />
                    新建频道
                  </Button>
                ) : null}
              </>
            ) : undefined
          }
        />
      </PageTopbar>
      <PageBody>
        {channels.isError && channels.data !== undefined ? (
          <PageNote
            tone="danger"
            title="刷新失败，已保留加载的内容"
            description="以下为上次成功加载的内容。"
            action={
              <Button variant="outline" size="sm" onClick={() => void channels.refetch()}>
                重试
              </Button>
            }
          />
        ) : null}

        {channels.isPending ? (
          <LoadingState rows={4} layout={view === 'cards' ? 'cards' : 'rows'} />
        ) : channels.isError && channels.data === undefined ? (
          <ErrorState error={channels.error} onRetry={() => void channels.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<Hash className="size-5" />}
            title="未创建频道"
            {...(canCreate ? {} : { description: '管理员把你加入频道后，频道会出现在这里。' })}
            action={
              canCreate ? (
                <Button variant="default" onClick={() => setCreating(true)}>
                  <Plus aria-hidden="true" />
                  新建频道
                </Button>
              ) : undefined
            }
          />
        ) : (
          <PageSection divided={false}>
            {view === 'cards' ? (
              <ul
                aria-label="频道列表"
                className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,256px),1fr))] gap-4 p-2"
              >
                {items.map((channel) => (
                  <li key={channel.id} className="min-w-0">
                    <ChannelCard channel={channel} />
                  </li>
                ))}
              </ul>
            ) : (
              <Table aria-label="频道列表">
                <TableHeader>
                  <TableRow>
                    <TableHead>频道</TableHead>
                    <TableHead>最近消息</TableHead>
                    <TableHead>成员</TableHead>
                    <TableHead>智能体</TableHead>
                    <TableHead>未读</TableHead>
                    <TableHead>更新时间</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((channel) => {
                    const last = channel.lastMessage;
                    return (
                      <TableRow key={channel.id}>
                        <TableCell className="max-w-72">
                          <div className="flex min-w-0 items-center gap-2">
                            <Link
                              to="/channels/$channelId"
                              params={{ channelId: channel.id }}
                              title={channel.name}
                              className="min-w-0 truncate rounded-item text-sm font-medium text-fg transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {channel.name}
                            </Link>
                            {channel.archivedAt ? <Badge variant="outline">已关闭</Badge> : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="block max-w-96 truncate">
                            {last === null ? (
                              <span className="text-muted-foreground">还没有消息</span>
                            ) : (
                              last.body
                            )}
                          </span>
                        </TableCell>
                        <TableCell className="tabular-nums text-muted-foreground">
                          {channel.memberCount}
                        </TableCell>
                        <TableCell className="tabular-nums text-muted-foreground">
                          {channel.agentCount}
                        </TableCell>
                        <TableCell>
                          {channel.unreadCount > 0 ? (
                            <Badge aria-label={`${channel.unreadCount} 条未读`}>
                              {channel.unreadCount}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatRelative(channel.updatedAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Link
                            to="/channels/$channelId"
                            params={{ channelId: channel.id }}
                            aria-label={`进入频道 ${channel.name}`}
                            className="text-link underline underline-offset-2 hover:text-link/80"
                          >
                            进入
                          </Link>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </PageSection>
        )}
      </PageBody>
      {creating ? <CreateChannelDialog onClose={() => setCreating(false)} /> : null}
    </Page>
  );
}

function ChannelCard({ channel }: { channel: ChannelListItem }) {
  const last = channel.lastMessage;

  return (
    <Link
      to="/channels/$channelId"
      params={{ channelId: channel.id }}
      className="group block h-full rounded-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card className={cn('h-full min-h-44 gap-3', channel.archivedAt && 'opacity-70')}>
        <CardHeader className="grid-cols-[auto_minmax(0,1fr)_auto]! items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-item bg-sunken text-muted-foreground">
            <Hash aria-hidden="true" />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle>
              <h2 className="flex min-w-0 items-center gap-2">
                <span
                  className="min-w-0 truncate text-base font-medium text-fg transition-colors group-hover:text-primary"
                  title={channel.name}
                >
                  {channel.name}
                </span>
                {channel.archivedAt ? <Badge variant="outline">已关闭</Badge> : null}
              </h2>
            </CardTitle>
            {channel.description ? (
              <CardDescription className="line-clamp-1">{channel.description}</CardDescription>
            ) : null}
          </div>
          {channel.unreadCount > 0 ? (
            <Badge aria-label={`${channel.unreadCount} 条未读`}>{channel.unreadCount}</Badge>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-1 flex-col justify-center">
          <p className="line-clamp-2 text-sm text-muted-foreground">
            {last === null ? '还没有消息' : last.body}
          </p>
        </CardContent>
        <CardContent className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">
            {channel.memberCount} 成员 · {channel.agentCount} 智能体
          </span>
          <span className="shrink-0 whitespace-nowrap">{formatRelative(channel.updatedAt)}</span>
        </CardContent>
      </Card>
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
  const guard = useDraftGuard(isDirty, pending, onClose);

  const submit = handleSubmit((values) => {
    const description = values.description?.trim();
    create.mutate(
      { name: values.name, ...(description ? { description } : {}) },
      {
        onSuccess: (channel) => {
          guard.finish();
          void navigate({
            to: '/channels/$channelId',
            params: { channelId: channel.id },
            ignoreBlocker: true,
          });
        },
        onError: (error) => toastError(error),
      },
    );
  });

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
            <Button type="button" variant="outline" disabled={pending} onClick={guard.close}>
              取消
            </Button>
            <Button type="submit" disabled={pending} aria-busy={pending}>
              {pending ? '创建中…' : '创建频道'}
            </Button>
          </div>
        </form>
        <DraftGuardDialogs guard={guard} draft="新建频道草稿会丢失。" pending={pending} />
      </DialogShell>
    </Dialog>
  );
}
