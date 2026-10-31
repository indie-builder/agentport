import type { PersonalOutputShare } from '@agentport/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { LockKeyhole, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { ConfirmDialog } from '../components/confirm-dialog.js';
import { CopyButton } from '../components/copy-button.js';
import { type DataColumn, DataTable } from '../components/data-table.js';
import { Page, PageHeader, PageToolbar } from '../components/page.js';
import { EmptyState, ErrorState } from '../components/states.js';
import { Button } from '../components/ui/button.js';
import { can } from '../lib/access.js';
import { errorMessage } from '../lib/api.js';
import { formatDateTime } from '../lib/format.js';
import { meQuery, usePersonalOutputShares, useRevokePersonalOutputShare } from '../lib/queries.js';
import { toastSuccess } from '../lib/toast.js';

function shareLink(share: PersonalOutputShare): string {
  return `${window.location.origin}${share.urlPath}`;
}

export function PersonalSharesPage() {
  const me = useQuery(meQuery);
  const search = useSearch({ from: '/_shell/personal/shares' });
  const navigate = useNavigate();
  const cursor = search.cursor ?? null;
  const shares = usePersonalOutputShares(cursor);
  const revoke = useRevokePersonalOutputShare();
  const [target, setTarget] = useState<PersonalOutputShare | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const canOpenConversation = can(me.data, 'conversations.read');

  const columns: DataColumn<PersonalOutputShare>[] = [
    {
      id: 'path',
      header: '文件',
      locked: true,
      width: 'minmax(180px,1.4fr)',
      cell: (share) => (
        <span className="block truncate font-mono text-xs text-fg" title={share.path}>
          {share.path}
        </span>
      ),
    },
    {
      id: 'conversation',
      header: '来源会话',
      width: 'minmax(160px,1fr)',
      cell: (share) =>
        canOpenConversation ? (
          <Link
            to="/chat"
            search={{ agent: share.agentId, conversation: share.conversationId }}
            className="block truncate text-sm text-primary underline underline-offset-4 hover:text-primary-hover"
            title={share.conversationTitle}
          >
            {share.conversationTitle}
          </Link>
        ) : (
          <span className="block truncate text-sm text-fg" title={share.conversationTitle}>
            {share.conversationTitle}
          </span>
        ),
    },
    {
      id: 'createdAt',
      header: '分享于',
      width: '110px',
      cell: (share) => (
        <span className="text-sm text-muted-foreground" title={share.createdAt}>
          {formatDateTime(share.createdAt)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: '操作',
      width: '84px',
      cell: (share) => (
        <div className="flex items-center justify-end gap-1">
          <CopyButton value={shareLink(share)} label={`复制 ${share.path} 的分享链接`} />
          <Button
            variant="outline"
            size="sm"
            aria-label={`撤销 ${share.path} 的分享`}
            disabled={revoke.isPending}
            onClick={() => {
              setActionError(null);
              setTarget(share);
            }}
          >
            撤销
          </Button>
        </div>
      ),
    },
  ];

  return (
    <Page>
      <PageHeader
        title="我的分享"
        actions={
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
        }
      />

      <PageToolbar>
        {cursor ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void navigate({ to: '/personal/shares', search: {} })}
          >
            回到最新
          </Button>
        ) : null}
        {shares.data ? (
          <span className="text-sm text-muted-foreground">本页 {shares.data.items.length} 条</span>
        ) : null}
        {shares.data?.nextCursor ? (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() =>
              void navigate({
                to: '/personal/shares',
                search: { cursor: shares.data?.nextCursor ?? undefined },
              })
            }
          >
            下一页
          </Button>
        ) : null}
      </PageToolbar>

      {actionError ? (
        <div role="alert" className="text-sm text-danger">
          {actionError}
        </div>
      ) : null}

      {shares.isError ? (
        <ErrorState error={shares.error} onRetry={() => void shares.refetch()} />
      ) : shares.data && shares.data.items.length === 0 ? (
        <EmptyState
          icon={<LockKeyhole className="size-5" />}
          title="还没有分享"
          description="在会话成果里分享文件后，链接会出现在这里。"
          action={
            <Link to="/chat" className="text-sm text-primary underline underline-offset-4">
              去对话
            </Link>
          }
        />
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

      <ConfirmDialog
        open={target !== null}
        onClose={() => setTarget(null)}
        title="撤销这次分享？"
        description={
          target ? `「${target.path}」的公开链接会立即失效，已打开的人也无法再访问。` : ''
        }
        confirmLabel="撤销分享"
        confirmDisabled={revoke.isPending}
        onConfirm={async () => {
          if (!target) return;
          try {
            await revoke.mutateAsync(target.id);
            setTarget(null);
            toastSuccess('分享已撤销');
          } catch (error) {
            setActionError(errorMessage(error));
          }
        }}
      />
    </Page>
  );
}
