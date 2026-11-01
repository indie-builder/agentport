import type { PersonalOutputShare } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { BusinessIllustration } from '../components/business-illustration.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { CopyButton } from '../components/copy-button.js';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { Page, PageHeader, PageToolbar } from '../components/page.js';
import { EmptyState, ErrorState, LoadingState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '../components/ui/card.js';
import { FieldError } from '../components/ui/field.js';
import { type ListView, ViewToggle } from '../components/view-toggle.js';
import { can } from '../lib/access.js';
import { errorMessage } from '../lib/api.js';
import { cn } from '../lib/cn.js';
import { formatDateTime } from '../lib/format.js';
import { meQuery, usePersonalOutputShares, useRevokePersonalOutputShare } from '../lib/queries.js';
import { toastSuccess } from '../lib/toast.js';

function shareLink(share: PersonalOutputShare): string {
  return `${window.location.origin}${share.urlPath}`;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

function ShareSourceCell({
  share,
  canOpenConversation,
}: {
  share: PersonalOutputShare;
  canOpenConversation: boolean;
}) {
  const [open, setOpen] = useState(false);
  const sourceTitle = share.conversationTitle || share.conversationId;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {open && canOpenConversation ? (
        <Link
          to="/chat"
          search={{ agent: share.agentId, conversation: share.conversationId }}
          className="break-words text-sm text-primary underline underline-offset-4 hover:text-primary-hover"
        >
          {sourceTitle}
        </Link>
      ) : (
        <span
          className={open ? 'break-words text-sm text-fg' : 'line-clamp-2 text-sm text-fg'}
          title={open ? undefined : sourceTitle}
        >
          {sourceTitle}
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 justify-start px-0 text-xs text-muted-foreground"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? '收起来源' : '展开来源'}
      </Button>
    </div>
  );
}

function ShareFile({ share }: { share: PersonalOutputShare }) {
  const name = fileName(share.path);
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="break-words text-base text-fg" title={share.path}>
        {name}
      </span>
      {name === share.path ? null : (
        <span className="break-all font-mono text-xs text-muted-foreground">{share.path}</span>
      )}
    </div>
  );
}

function ShareActions({
  share,
  revokePending,
  onRevoke,
  className,
}: {
  share: PersonalOutputShare;
  revokePending: boolean;
  onRevoke: (share: PersonalOutputShare) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-x-3 whitespace-nowrap', className)}>
      <a
        href={share.urlPath}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm text-primary underline underline-offset-4 hover:text-primary-hover"
      >
        查看分享
      </a>
      <CopyButton value={shareLink(share)} label="复制链接" showLabel />
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-danger"
        aria-label={`撤销 ${fileName(share.path)} 的分享`}
        disabled={revokePending}
        onClick={() => onRevoke(share)}
      >
        撤销
      </Button>
    </div>
  );
}

function ShareCard({
  share,
  canOpenConversation,
  revokePending,
  onRevoke,
}: {
  share: PersonalOutputShare;
  canOpenConversation: boolean;
  revokePending: boolean;
  onRevoke: (share: PersonalOutputShare) => void;
}) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="min-w-0">
          <ShareFile share={share} />
        </CardTitle>
        <span className="text-xs text-muted-foreground" title={share.createdAt}>
          分享于 {formatDateTime(share.createdAt)}
        </span>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-1">
        <span className="text-xs text-muted-foreground">来源会话</span>
        <ShareSourceCell share={share} canOpenConversation={canOpenConversation} />
      </CardContent>
      <CardFooter className="justify-end">
        <ShareActions
          share={share}
          revokePending={revokePending}
          onRevoke={onRevoke}
          className="flex-wrap justify-end gap-y-1"
        />
      </CardFooter>
    </Card>
  );
}

export function PersonalSharesPage() {
  const me = useQuery(meQuery);
  const search = useSearch({ from: '/_shell/personal/shares' });
  const navigate = useNavigate({ from: '/personal/shares' });
  const cursor = search.cursor ?? null;
  const view = search.view ?? 'table';
  const shares = usePersonalOutputShares(cursor);
  const revoke = useRevokePersonalOutputShare();
  const [target, setTarget] = useState<PersonalOutputShare | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const canOpenConversation = can(me.data, 'conversations.read');

  const requestRevoke = (share: PersonalOutputShare): void => {
    setModalError(null);
    setTarget(share);
  };

  const columns: DataColumn<PersonalOutputShare>[] = [
    {
      id: 'file',
      header: '文件',
      locked: true,
      width: 'minmax(150px,1.4fr)',
      cell: (share) => <ShareFile share={share} />,
    },
    {
      id: 'conversation',
      header: '来源会话',
      width: 'minmax(140px,1fr)',
      cell: (share) => <ShareSourceCell share={share} canOpenConversation={canOpenConversation} />,
    },
    {
      id: 'createdAt',
      header: '分享于',
      width: '96px',
      cell: (share) => (
        <span className="block text-sm text-muted-foreground" title={share.createdAt}>
          {formatDateTime(share.createdAt)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: '操作',
      align: 'end',
      width: 'minmax(270px,auto)',
      cell: (share) => (
        <ShareActions
          share={share}
          revokePending={revoke.isPending}
          onRevoke={requestRevoke}
          className="justify-end"
        />
      ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="我的分享"
        actions={
          <>
            <ViewToggle
              value={view}
              onChange={(next: ListView) =>
                void navigate({
                  to: '/personal/shares',
                  search: (current) => ({ ...current, view: next }),
                })
              }
            />
            <Button
              variant="outline"
              onClick={() => void shares.refetch()}
              disabled={shares.isFetching}
            >
              <RefreshCw
                data-icon="inline-start"
                className={shares.isFetching ? 'animate-spin' : undefined}
                aria-hidden="true"
              />
              {shares.isFetching ? '刷新中…' : '刷新'}
            </Button>
          </>
        }
      />

      {shares.isError ? (
        <ErrorState error={shares.error} onRetry={() => void shares.refetch()} />
      ) : shares.data && shares.data.items.length === 0 ? (
        <EmptyState
          illustration={<BusinessIllustration name="sharing" />}
          title="还没有分享"
          description="在会话成果里分享文件后，链接会出现在这里。"
          action={
            <Link to="/chat" className="text-sm text-primary underline underline-offset-4">
              去对话
            </Link>
          }
        />
      ) : view === 'cards' ? (
        shares.isPending ? (
          <LoadingState rows={3} layout="cards" />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {(shares.data?.items ?? []).map((share) => (
              <ShareCard
                key={share.id}
                share={share}
                canOpenConversation={canOpenConversation}
                revokePending={revoke.isPending}
                onRevoke={requestRevoke}
              />
            ))}
          </div>
        )
      ) : (
        <DataTable
          rows={shares.data?.items ?? []}
          columns={columns}
          rowKey={(share) => share.id}
          label="我的会话分享"
          loading={shares.isPending}
          empty="还没有分享"
        />
      )}

      {cursor || shares.data?.nextCursor ? (
        <PageToolbar>
          {cursor ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void navigate({
                  to: '/personal/shares',
                  search: (current) => ({ ...current, cursor: undefined }),
                })
              }
            >
              回到最新
            </Button>
          ) : null}
          {shares.data?.nextCursor ? (
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() =>
                void navigate({
                  to: '/personal/shares',
                  search: (current) => ({
                    ...current,
                    cursor: shares.data?.nextCursor ?? undefined,
                  }),
                })
              }
            >
              下一页
            </Button>
          ) : null}
        </PageToolbar>
      ) : null}

      <ConfirmDialog
        open={target !== null}
        onClose={() => {
          setTarget(null);
          setModalError(null);
        }}
        title="撤销这次分享？"
        description={
          target ? `「${fileName(target.path)}」的公开链接会立即失效，已打开的人也无法再访问。` : ''
        }
        confirmLabel="撤销分享"
        confirmDisabled={revoke.isPending}
        onConfirm={async () => {
          if (!target) return;
          try {
            await revoke.mutateAsync(target.id);
            setTarget(null);
            setModalError(null);
            toastSuccess('分享已撤销');
          } catch (error) {
            setModalError(errorMessage(error));
            // 继续抛出让 ConfirmDialog 保持弹层，错误已在本弹层内展示。
            throw error;
          }
        }}
      >
        {modalError ? <FieldError>{modalError}</FieldError> : null}
      </ConfirmDialog>
    </Page>
  );
}
